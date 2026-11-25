"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Copy, FileText, ImageOff, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VISUAL_FORMATS } from "@/lib/brand-visual-system";
import { stylePackSample } from "@/lib/style-pack-samples";
import { stylePack } from "@/lib/style-pack-catalog";
import { normalizeSubtitleStylePresetConfig } from "@/lib/editor-style-preset-contract";
import { paintMotionBrollCanvas } from "@/remotion/MotionBrollScene";
import {
  isMotionMascotId,
  isMotionThemeId,
  motionTemplatesForTheme,
  resolveMotionBrandCiFromPalette,
  type MotionTemplateConfig,
  type MotionThemeId,
} from "@/lib/motion-broll-catalog";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import { MOTION_THEME_META, resolveEffectiveBrollSource } from "./brand-kit-constants";
import type { BrandPayload, BrandProfile, LibraryResponse } from "./types";

function BrandCardThumbnail({
  payload,
  library,
}: {
  payload: BrandPayload | null | undefined;
  library: LibraryResponse;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  const effectiveSource = payload
    ? resolveEffectiveBrollSource(payload.visual, payload.subtitle.config)
    : "stock";
  const isMotion = effectiveSource === "motion";
  const motionThemeId: MotionThemeId = isMotionThemeId(payload?.visual.motionThemeId)
    ? payload!.visual.motionThemeId!
    : isMotionThemeId(payload?.subtitle.config?.motionThemeId)
      ? (payload!.subtitle.config!.motionThemeId as MotionThemeId)
      : "apple-bento-glass";
  const motionMascot = isMotionMascotId(payload?.visual.motionMascot)
    ? payload!.visual.motionMascot!
    : isMotionMascotId(payload?.subtitle.config?.motionMascot)
      ? payload!.subtitle.config!.motionMascot
      : "stickman-scarf";

  const subConfig = useMemo(
    () => normalizeSubtitleStylePresetConfig(payload?.subtitle.config) ?? stylePack("life-drama").subtitle,
    [payload?.subtitle.config],
  );

  const motionConfig = useMemo<MotionTemplateConfig | null>(() => {
    if (!isMotion || !payload) return null;
    const tpl = motionTemplatesForTheme(motionThemeId)[0];
    if (!tpl) return null;
    return {
      templateId: tpl.id,
      themeId: motionThemeId,
      brandCi: resolveMotionBrandCiFromPalette({
        themeId: motionThemeId,
        palette: payload.visual.palette,
        fontFamily: subConfig.fontFamily,
        accentColor: subConfig.accentColor,
      }),
      mascot: motionMascot,
      props: { ...tpl.defaultProps, mascot: motionMascot },
    };
  }, [isMotion, motionMascot, motionThemeId, payload, subConfig.accentColor, subConfig.fontFamily]);

  useEffect(() => {
    if (!isMotion || !motionConfig) return;
    paintMotionBrollCanvas(canvasRef.current, motionConfig, 0.72);
  }, [isMotion, motionConfig]);

  const pack = payload?.visual.stylePackId
    ? library.stylePacks.find((item) => item.id === payload.visual.stylePackId) ?? null
    : null;
  const format = payload?.visual.primaryVisualFormatId
    ? library.visualFormats.find((item) => item.id === payload.visual.primaryVisualFormatId) ?? null
    : null;
  const sample = pack ? stylePackSample(pack.id) : null;
  const thumbUrl = !imgFailed ? (sample?.imageUrl ?? format?.previewUrl ?? null) : null;
  const logoAsset = payload?.brandMark.enabled && payload.brandMark.assetId
    ? library.brandAssets.find((item) => item.id === payload.brandMark.assetId) ?? null
    : null;

  return (
    <div className="relative aspect-[9/16] w-[80px] shrink-0 overflow-hidden rounded-xl border border-border bg-zinc-950">
      {isMotion ? (
        <canvas ref={canvasRef} width={180} height={320} className="h-full w-full object-cover" />
      ) : thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbUrl}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <ImageOff className="h-4 w-4" />
        </div>
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/75" />
      {logoAsset ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/user/brand-assets/${logoAsset.id}/image`}
          alt=""
          className="pointer-events-none absolute right-1.5 top-1.5 max-h-4 max-w-[40%] object-contain opacity-90"
        />
      ) : null}
      <div className="pointer-events-none absolute inset-x-1.5 bottom-1.5 truncate rounded bg-black/70 px-1 py-0.5 text-center text-[8px] font-bold text-white">
        {subConfig.fontFamily}
      </div>
    </div>
  );
}

export function BrandLibraryOverview({
  library,
  busy,
  canCreateVideo = true,
  onNew,
  onOpen,
  onUse,
  onArchive,
}: {
  library: LibraryResponse;
  busy: boolean;
  canCreateVideo?: boolean;
  onNew: () => void;
  onOpen: (profile: BrandProfile) => void;
  onUse: (profile: BrandProfile) => void;
  onArchive: (profile: BrandProfile) => void;
}) {
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function copyMcpSnippet(profile: BrandProfile) {
    const prompt = `สร้างคลิปแนวตั้งด้วย HERO AI MCP โดยใช้ Brand Kit "${profile.name}" (brandProfileId: "${profile.id}") ให้ดึงสไตล์ภาพ เสียง ซับไตเติล และโลโก้ของแบรนด์นี้ทั้งหมด`;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedId(profile.id);
      window.setTimeout(() => {
        setCopiedId((current) => (current === profile.id ? null : current));
      }, 2200);
    } catch {
      // Fallback: silent no-op if clipboard unavailable in headless browser
    }
  }

  return (
    <section className="min-w-0" aria-label="คลังแบรนด์">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {library.profiles.length} แบรนด์{library.cap !== null ? ` จาก ${library.cap} แบรนด์ตามแผน` : ""}
          </p>
          {!library.canCreate ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              บันทึกครบตามแผนแล้ว เลือกใช้หรือแก้ไขแบรนด์ที่มี หรือ{" "}
              <Link href="/pricing?source=brands_cap" className="font-semibold text-violet-400 underline underline-offset-4">
                อัปเกรดเพื่อเพิ่มช่อง
              </Link>
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={onNew}
          disabled={busy || !library.canCreate}
          className="min-h-11"
        >
          <Plus className="h-4 w-4" />
          สร้างแบรนด์ใหม่
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
        {library.profiles.map((profile) => {
          const payload = profile.revisions.find((item) => item.version === profile.activeRevisionNumber)?.payload
            ?? profile.draft?.payload
            ?? null;
          const pack = library.stylePacks.find((item) => item.id === payload?.visual.stylePackId);
          const format = VISUAL_FORMATS.find((item) => item.id === payload?.visual.primaryVisualFormatId);
          const effectiveSource = payload ? resolveEffectiveBrollSource(payload.visual, payload.subtitle.config) : "stock";
          const isMotion = effectiveSource === "motion";
          const motionThemeId: MotionThemeId = isMotionThemeId(payload?.visual.motionThemeId)
            ? payload!.visual.motionThemeId!
            : isMotionThemeId(payload?.subtitle.config?.motionThemeId)
              ? (payload!.subtitle.config!.motionThemeId as MotionThemeId)
              : "apple-bento-glass";
          const modeLabel = isMotion
            ? `Motion · ${MOTION_THEME_META[motionThemeId].shortLabel}`
            : pack?.thaiLabel ?? format?.label ?? "สไตล์ที่บันทึกไว้";
          const palette = payload?.visual.palette ?? [];
          const unavailable = profile.frozen || profile.legacyVisualFormat;
          const voiceLabel = payload?.voice.provider === "gemini"
            ? (GEMINI_VOICES.find((v) => v.id === payload.voice.voiceId)?.label ?? "Gemini AI")
            : payload?.voice.provider === "omnivoice"
              ? "Hero Voice"
              : payload?.voice.provider === "elevenlabs"
                ? "ElevenLabs"
                : "เสียง AI";
          const hasLogo = Boolean(payload?.brandMark.enabled && payload?.brandMark.assetId);

          return (
            <article
              key={profile.id}
              className="flex min-w-0 flex-col justify-between gap-4 rounded-2xl border border-border bg-card p-4 transition-colors hover:border-violet-500/35"
            >
              <div className="flex items-start gap-3.5">
                <BrandCardThumbnail payload={payload} library={library} />

                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="break-words text-base font-semibold leading-snug text-foreground">
                      {profile.name}
                    </h2>
                    <span className="shrink-0 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      v{profile.activeRevisionNumber}
                    </span>
                  </div>

                  <p className="truncate text-xs font-medium text-violet-400">
                    {modeLabel}
                    {unavailable ? " · อ่านอย่างเดียว" : ""}
                  </p>

                  {profile.niche && profile.niche !== "วิดีโอสั้นให้ความรู้และเล่าเรื่อง" ? (
                    <p className="line-clamp-2 text-xs leading-4 text-muted-foreground">{profile.niche}</p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    {palette.slice(0, 3).map((hex, i) => (
                      <span
                        key={`${profile.id}-${hex}-${i}`}
                        title={hex}
                        className="h-4 w-4 rounded-full border border-border"
                        style={{ backgroundColor: hex }}
                      />
                    ))}
                    <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                      {voiceLabel}
                    </span>
                    {hasLogo ? (
                      <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                        โลโก้
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* MAPC Primary + Secondary Actions */}
              <div className="space-y-2 border-t border-border pt-3">
                <div className="flex flex-wrap gap-2">
                  {canCreateVideo ? (
                    <Button
                      type="button"
                      disabled={busy || unavailable}
                      onClick={() => onUse(profile)}
                      className="min-h-11 flex-1 bg-violet-600 text-white hover:bg-violet-600/90"
                    >
                      สร้างคลิป
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button
                      asChild
                      className="min-h-11 flex-1 bg-violet-600 text-white hover:bg-violet-600/90"
                    >
                      <Link href="/pricing?source=brands_library">
                        <Sparkles className="h-4 w-4" />
                        อัปเกรดเพื่อสร้างคลิป
                      </Link>
                    </Button>
                  )}
                  <Button
                    asChild
                    variant="outline"
                    className="min-h-11 shrink-0 px-3"
                  >
                    <Link href={`/hero-script?brandId=${encodeURIComponent(profile.id)}`}>
                      <FileText className="h-4 w-4" />
                      เขียนสคริปต์
                    </Link>
                  </Button>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => onOpen(profile)}
                    className="min-h-10 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    {unavailable ? "ดูรายละเอียด" : "แก้ไข"}
                  </Button>

                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void copyMcpSnippet(profile)}
                      className="min-h-10 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {copiedId === profile.id ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                          คัดลอกแล้ว
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          ใช้กับ MCP
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setArchiveId(archiveId === profile.id ? null : profile.id)}
                      aria-label={`ลบแบรนด์ ${profile.name}`}
                      className="min-h-10 min-w-10 px-2 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>

              {archiveId === profile.id ? (
                <div role="alert" className="rounded-xl border border-border bg-muted/35 p-3.5 text-xs">
                  <p className="leading-5 text-foreground">
                    ลบออกจากคลังสำหรับงานใหม่ คลิปเดิมและเวอร์ชันเก่ายังอยู่ครบ
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => setArchiveId(null)}>
                      ยกเลิก
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => {
                        setArchiveId(null);
                        onArchive(profile);
                      }}
                    >
                      ยืนยันลบ
                    </Button>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
