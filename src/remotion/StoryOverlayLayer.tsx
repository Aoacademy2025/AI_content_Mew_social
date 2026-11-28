import React from "react";
import {
  AbsoluteFill,
  Easing,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { StoryOverlayItem } from "../lib/story-overlays";
import {
  coordinateStoryOverlays,
  resolveFaceSafeStickerPosition,
  resolveFaceSafeVerticalPercent,
  type ActiveSubtitleBand,
  type AvoidScreenBand,
  type FaceBox,
} from "../lib/face-safe-placement";
import { segmentThaiDisplayWordBreaks } from "./renderSubtitle";

function safeThai(text: string): string {
  return segmentThaiDisplayWordBreaks(text);
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return `rgba(255, 229, 0, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return `rgba(255, 229, 0, ${alpha})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function HeroFreezeCardOverlay({
  item,
  durationInFrames,
  accentColor,
  fontFamily,
  faceBoxes,
}: {
  item: StoryOverlayItem;
  durationInFrames: number;
  accentColor: string;
  fontFamily: string;
  faceBoxes?: readonly FaceBox[];
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Camera shutter flash: crisp white burst over frames 0..6 + subtle viewfinder frame
  const flashOpacity = interpolate(frame, [0, 2, 7], [0.85, 0.45, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cardSpring = spring({
    frame: Math.max(0, frame - 2),
    fps,
    config: { damping: 14, stiffness: 210, mass: 0.8 },
  });
  const fadeOut = interpolate(
    frame,
    [Math.max(1, durationInFrames - 7), durationInFrames],
    [1, 0],
    { easing: Easing.inOut(Easing.ease), extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // Place card below face if face is in upper half, else upper-lower safe zone (64%)
  const hasLowerFace = (faceBoxes ?? []).some((f) => f.y + f.height > 0.58);
  const topPercent = hasLowerFace ? 16 : 64;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {/* White camera shutter flash */}
      {flashOpacity > 0.01 && (
        <AbsoluteFill
          style={{
            backgroundColor: "#FFFFFF",
            opacity: flashOpacity,
            mixBlendMode: "screen",
          }}
        />
      )}

      {/* Subtle viewfinder corner brackets */}
      <div
        style={{
          position: "absolute",
          inset: "44px 38px",
          border: `2px solid ${hexToRgba("#FFFFFF", 0.24 * fadeOut)}`,
          borderRadius: 28,
          opacity: fadeOut,
        }}
      />

      {/* Editorial Hero Character / Highlight Card */}
      <div
        style={{
          position: "absolute",
          top: `${topPercent}%`,
          left: "6.5%",
          right: "6.5%",
          display: "flex",
          justifyContent: "center",
          opacity: fadeOut * Math.min(1, cardSpring * 1.3),
          transform: `translate3d(0, ${(1 - cardSpring) * 28}px, 0) scale(${0.92 + 0.08 * cardSpring})`,
        }}
      >
        <div
          style={{
            background: "linear-gradient(145deg, rgba(12, 14, 22, 0.90) 0%, rgba(20, 24, 38, 0.84) 100%)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
            border: `2px solid ${hexToRgba(accentColor, 0.78)}`,
            borderRadius: 26,
            padding: "20px 30px 22px",
            boxShadow: `0 18px 44px rgba(0, 0, 0, 0.55), 0 0 28px ${hexToRgba(accentColor, 0.22)}`,
            maxWidth: 920,
            width: "100%",
            fontFamily,
            textAlign: "center",
          }}
        >
          {item.badge && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 14px",
                borderRadius: 999,
                background: hexToRgba(accentColor, 0.18),
                border: `1px solid ${hexToRgba(accentColor, 0.52)}`,
                color: accentColor,
                fontSize: 25,
                fontWeight: 600,
                letterSpacing: "0.04em",
                marginBottom: 8,
              }}
            >
              <span>✦</span>
              <span>{safeThai(item.badge)}</span>
            </div>
          )}
          <div
            style={{
              fontSize: 54,
              fontWeight: 700,
              lineHeight: 1.32,
              color: "#FFFFFF",
              letterSpacing: "0.01em",
              textShadow: "0 3px 12px rgba(0,0,0,0.65)",
              wordBreak: "keep-all",
              overflowWrap: "break-word",
            }}
          >
            {safeThai(item.title)}
          </div>
          {item.subtitle && (
            <div
              style={{
                marginTop: 6,
                fontSize: 32,
                fontWeight: 500,
                lineHeight: 1.36,
                color: accentColor,
                wordBreak: "keep-all",
                overflowWrap: "break-word",
              }}
            >
              {safeThai(item.subtitle)}
            </div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function ChapterPillOverlay({
  item,
  durationInFrames,
  accentColor,
  fontFamily,
}: {
  item: StoryOverlayItem;
  durationInFrames: number;
  accentColor: string;
  fontFamily: string;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: { damping: 16, stiffness: 200, mass: 0.7 },
  });
  const exit = interpolate(
    frame,
    [Math.max(1, durationInFrames - 8), durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const isRight = item.position === "top-right";

  return (
    <div
      style={{
        position: "absolute",
        top: "6.8%",
        ...(isRight ? { right: "5.5%" } : { left: "5.5%" }),
        pointerEvents: "none",
        opacity: Math.min(1, enter * 1.4) * exit,
        transform: `translate3d(${(1 - enter) * (isRight ? 24 : -24)}px, 0, 0) scale(${0.94 + 0.06 * enter})`,
        fontFamily,
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 22px 11px",
          borderRadius: 999,
          background: "rgba(12, 15, 24, 0.80)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          border: `1.5px solid ${hexToRgba(accentColor, 0.65)}`,
          boxShadow: "0 10px 26px rgba(0, 0, 0, 0.42)",
        }}
      >
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: 999,
            backgroundColor: accentColor,
            boxShadow: `0 0 10px ${accentColor}`,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 30,
            fontWeight: 600,
            lineHeight: 1.32,
            color: "#FFFFFF",
            wordBreak: "keep-all",
          }}
        >
          {safeThai(item.title)}
        </span>
        {item.subtitle && (
          <span
            style={{
              fontSize: 25,
              fontWeight: 500,
              lineHeight: 1.32,
              color: accentColor,
              paddingLeft: 8,
              borderLeft: "1px solid rgba(255,255,255,0.18)",
              wordBreak: "keep-all",
            }}
          >
            {safeThai(item.subtitle)}
          </span>
        )}
      </div>
    </div>
  );
}

function ChecklistPopOverlay({
  item,
  durationInFrames,
  accentColor,
  fontFamily,
  faceBoxes,
  hasTopChapterPill,
  activeSubtitles,
}: {
  item: StoryOverlayItem;
  durationInFrames: number;
  accentColor: string;
  fontFamily: string;
  faceBoxes?: readonly FaceBox[];
  hasTopChapterPill?: boolean;
  activeSubtitles?: readonly ActiveSubtitleBand[];
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const items = item.items ?? [];

  const exit = interpolate(
    frame,
    [Math.max(1, durationInFrames - 8), durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // Pick a vertical slot that avoids upper-left faces, top chapter pills, AND bottom subtitles!
  const upperLeftFace = (faceBoxes ?? []).some((f) => f.y < 0.36 && f.x < 0.58);
  const minSubTop = activeSubtitles?.length
    ? Math.min(...activeSubtitles.map((s) => s.topPercent))
    : 80;
  const topPercent = upperLeftFace
    ? Math.min(46, Math.max(38, minSubTop - 32))
    : (hasTopChapterPill ? 16 : 13.5);

  return (
    <div
      style={{
        position: "absolute",
        top: `${topPercent}%`,
        left: "5.8%",
        maxWidth: "78%",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        pointerEvents: "none",
        opacity: exit,
        fontFamily,
      }}
    >
      {item.title && item.title !== "เช็กลิสต์ภารกิจ" && (
        <div
          style={{
            alignSelf: "flex-start",
            padding: "6px 16px",
            borderRadius: 999,
            background: "rgba(12, 15, 24, 0.82)",
            border: `1px solid ${hexToRgba(accentColor, 0.5)}`,
            color: accentColor,
            fontSize: 25,
            fontWeight: 600,
            lineHeight: 1.32,
          }}
        >
          {safeThai(item.title)}
        </div>
      )}
      {items.map((entry, idx) => {
        const appearFrame = Math.round(((entry.appearOffsetMs ?? idx * 420) / 1000) * fps);
        if (frame < appearFrame) return null;
        const pop = spring({
          frame: frame - appearFrame,
          fps,
          config: { damping: 13, stiffness: 230, mass: 0.72 },
        });
        return (
          <div
            key={`${idx}-${entry.text}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 14,
              alignSelf: "flex-start",
              padding: "11px 22px 12px 16px",
              borderRadius: 20,
              background: "rgba(14, 18, 28, 0.86)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              border: "1.5px solid rgba(255, 255, 255, 0.16)",
              boxShadow: "0 10px 26px rgba(0, 0, 0, 0.45)",
              opacity: Math.min(1, pop * 1.4),
              transform: `translate3d(${(1 - pop) * -22}px, 0, 0) scale(${0.9 + 0.1 * pop})`,
            }}
          >
            <span
              style={{
                width: 38,
                height: 38,
                borderRadius: 999,
                background: accentColor,
                color: "#0B0F19",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 24,
                fontWeight: 800,
                flexShrink: 0,
                boxShadow: `0 0 14px ${hexToRgba(accentColor, 0.55)}`,
              }}
            >
              ✓
            </span>
            <span
              style={{
                fontSize: 33,
                fontWeight: 600,
                lineHeight: 1.35,
                color: "#FFFFFF",
                wordBreak: "keep-all",
              }}
            >
              {safeThai(entry.text)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function CountdownOverlay({
  item,
  durationInFrames,
  accentColor,
  fontFamily,
  faceBoxes,
}: {
  item: StoryOverlayItem;
  durationInFrames: number;
  accentColor: string;
  fontFamily: string;
  faceBoxes?: readonly FaceBox[];
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const steps = item.items?.length
    ? item.items.map((x) => x.text)
    : ["3", "2", "1"];
  const stepDur = Math.max(4, Math.floor(durationInFrames / steps.length));
  const activeIdx = Math.min(steps.length - 1, Math.floor(frame / stepDur));
  const localFrame = frame - activeIdx * stepDur;

  const pop = spring({
    frame: localFrame,
    fps,
    config: { damping: 11, stiffness: 250, mass: 0.7 },
  });
  const fade = interpolate(localFrame, [0, stepDur - 3, stepDur], [1, 1, 0.2], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Place countdown in the upper editorial zone (~20%) by default and shift away from any detected faces!
  const safeTopPct = faceBoxes?.length
    ? resolveFaceSafeVerticalPercent({
        faceBoxes,
        preferredTopPercent: 20,
        overlayHeightPercent: 18,
        role: "hook",
      })
    : 20;
  const captionLabel = item.subtitle || item.title;

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        alignItems: "center",
        fontFamily,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: `${safeTopPct}%`,
          transform: `translateY(-50%) scale(${0.65 + 0.42 * pop})`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          opacity: fade,
        }}
      >
        <div
          style={{
            width: 168,
            height: 168,
            borderRadius: 999,
            background: "rgba(10, 12, 20, 0.78)",
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
            border: `4px solid ${accentColor}`,
            boxShadow: `0 20px 54px rgba(0,0,0,0.6), 0 0 36px ${hexToRgba(accentColor, 0.45)}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 94,
            fontWeight: 800,
            color: "#FFFFFF",
            textShadow: `0 4px 18px ${hexToRgba(accentColor, 0.65)}`,
          }}
        >
          {safeThai(steps[activeIdx] ?? "1")}
        </div>
        {captionLabel && (
          <div
            style={{
              marginTop: 14,
              padding: "8px 22px",
              borderRadius: 999,
              background: "rgba(10, 12, 20, 0.85)",
              border: `1.5px solid ${hexToRgba(accentColor, 0.55)}`,
              color: accentColor,
              fontSize: 28,
              fontWeight: 600,
              lineHeight: 1.32,
            }}
          >
            {safeThai(captionLabel)}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
}

function CalloutStickerOverlay({
  item,
  durationInFrames,
  accentColor,
  fontFamily,
  faceBoxes,
  seedIndex,
  avoidBands,
}: {
  item: StoryOverlayItem;
  durationInFrames: number;
  accentColor: string;
  fontFamily: string;
  faceBoxes?: readonly FaceBox[];
  seedIndex: number;
  avoidBands: readonly AvoidScreenBand[];
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const pop = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 240, mass: 0.68 },
  });
  const exit = interpolate(
    frame,
    [Math.max(1, durationInFrames - 7), durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const slot = resolveFaceSafeStickerPosition({
    faceBoxes,
    seedIndex,
    avoidBands,
  });

  const isRight = slot.align === "right";

  return (
    <div
      style={{
        position: "absolute",
        top: `${slot.topPercent}%`,
        ...(isRight ? { right: "14%" } : { left: `${slot.leftPercent}%` }),
        maxWidth: "72%",
        pointerEvents: "none",
        opacity: Math.min(1, pop * 1.4) * exit,
        transform: `rotate(${slot.tiltDeg}deg) scale(${0.82 + 0.18 * pop})`,
        transformOrigin: isRight ? "right center" : "left center",
        fontFamily,
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 22px 12px",
          borderRadius: 999,
          background: "rgba(14, 17, 27, 0.90)",
          border: `2.5px solid ${accentColor}`,
          boxShadow: `0 12px 28px rgba(0, 0, 0, 0.52), 0 0 18px ${hexToRgba(accentColor, 0.28)}`,
        }}
      >
        {item.badge && (
          <span style={{ fontSize: 30, lineHeight: 1 }}>{item.badge}</span>
        )}
        <span
          style={{
            fontSize: 34,
            fontWeight: 700,
            lineHeight: 1.34,
            color: accentColor,
            textShadow: "0 2px 8px rgba(0,0,0,0.65)",
            wordBreak: "keep-all",
          }}
        >
          {safeThai(item.title)}
        </span>
      </div>
    </div>
  );
}

function BlooperEndOverlay({
  item,
  durationInFrames,
  accentColor,
  fontFamily,
}: {
  item: StoryOverlayItem;
  durationInFrames: number;
  accentColor: string;
  fontFamily: string;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Fake fade-to-black over frames 0..10, then SNAP open at frame 11 on record-scratch!
  const fakeBlackOpacity = interpolate(frame, [0, 8, 11, 13], [0, 0.94, 0.94, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const badgePop = spring({
    frame: Math.max(0, frame - 11),
    fps,
    config: { damping: 13, stiffness: 230, mass: 0.72 },
  });
  const showBadge = frame >= 11 && frame <= durationInFrames;

  return (
    <AbsoluteFill style={{ pointerEvents: "none", fontFamily }}>
      {fakeBlackOpacity > 0.01 && (
        <AbsoluteFill style={{ backgroundColor: "#000000", opacity: fakeBlackOpacity }} />
      )}
      {showBadge && (
        <div
          style={{
            position: "absolute",
            top: "13%",
            left: "6%",
            opacity: Math.min(1, badgePop * 1.35),
            transform: `rotate(-2deg) scale(${0.86 + 0.14 * badgePop})`,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 20px 10px",
              borderRadius: 16,
              background: "rgba(15, 18, 28, 0.88)",
              border: `2px solid ${accentColor}`,
              boxShadow: "0 10px 26px rgba(0,0,0,0.48)",
            }}
          >
            <span
              style={{
                padding: "2px 10px",
                borderRadius: 999,
                background: accentColor,
                color: "#0B0F19",
                fontSize: 22,
                fontWeight: 800,
              }}
            >
              {safeThai(item.badge || "BLOOPER")}
            </span>
            <span
              style={{
                fontSize: 30,
                fontWeight: 600,
                lineHeight: 1.34,
                color: "#FFFFFF",
                wordBreak: "keep-all",
              }}
            >
              {safeThai(item.title)}
            </span>
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
}

export function StoryOverlayLayer({
  overlays,
  defaultAccentColor = "#FFE500",
  fontFamily = "'Kanit', 'Noto Sans Thai', sans-serif",
  resolveFaceBoxesAtMs,
  activeSubtitleBands,
  headlineHookEndMs = 0,
}: {
  overlays: readonly StoryOverlayItem[];
  defaultAccentColor?: string;
  fontFamily?: string;
  resolveFaceBoxesAtMs?: (ms: number) => readonly FaceBox[] | undefined;
  activeSubtitleBands?: readonly ActiveSubtitleBand[];
  headlineHookEndMs?: number;
}) {
  const { fps, durationInFrames } = useVideoConfig();

  if (!overlays || overlays.length === 0) return null;

  const coordinated = coordinateStoryOverlays(overlays, headlineHookEndMs);
  if (coordinated.length === 0) return null;

  return (
    <>
      {coordinated.map((item, idx) => {
        const fromFrame = Math.max(0, Math.round((item.startMs / 1000) * fps));
        const endFrame = Math.min(durationInFrames, Math.round((item.endMs / 1000) * fps));
        const durFrames = endFrame - fromFrame;
        if (durFrames <= 0) return null;

        const accent = item.accentColor || defaultAccentColor;
        const midMs = (item.startMs + item.endMs) * 0.5;
        const faceBoxes = resolveFaceBoxesAtMs ? resolveFaceBoxesAtMs(midMs) : undefined;
        const overlappingSubs = (activeSubtitleBands ?? []).filter(
          (s) => s.endMs > item.startMs && s.startMs < item.endMs,
        );
        const overlappingChapterPills = coordinated.filter(
          (o) => o.kind === "chapter-pill" && o.endMs > item.startMs && o.startMs < item.endMs,
        );
        const overlappingBloopers = coordinated.filter(
          (o) => o.kind === "blooper-end" && o.endMs > item.startMs && o.startMs < item.endMs,
        );

        const stickerAvoidBands: AvoidScreenBand[] = [];
        if (overlappingSubs.length > 0) {
          for (const sub of overlappingSubs) {
            stickerAvoidBands.push({
              top: Math.max(0, sub.topPercent - 8),
              bottom: Math.min(100, sub.topPercent + 10),
              left: 0,
              right: 100,
            });
          }
        } else {
          stickerAvoidBands.push({ top: 71, bottom: 88, left: 0, right: 100 });
        }
        for (const pill of overlappingChapterPills) {
          const isRightPill = pill.position === "top-right";
          stickerAvoidBands.push({
            top: 5,
            bottom: 14.5,
            left: isRightPill ? 38 : 0,
            right: isRightPill ? 100 : 68,
          });
        }
        for (const _blp of overlappingBloopers) {
          stickerAvoidBands.push({ top: 10, bottom: 23, left: 0, right: 76 });
        }

        return (
          <Sequence
            key={item.id || `story-ov-${idx}-${item.kind}-${fromFrame}`}
            from={fromFrame}
            durationInFrames={durFrames}
            layout="none"
          >
            {item.kind === "hero-freeze-card" && (
              <HeroFreezeCardOverlay
                item={item}
                durationInFrames={durFrames}
                accentColor={accent}
                fontFamily={fontFamily}
                faceBoxes={faceBoxes}
              />
            )}
            {item.kind === "chapter-pill" && (
              <ChapterPillOverlay
                item={item}
                durationInFrames={durFrames}
                accentColor={accent}
                fontFamily={fontFamily}
              />
            )}
            {item.kind === "checklist-pop" && (
              <ChecklistPopOverlay
                item={item}
                durationInFrames={durFrames}
                accentColor={accent}
                fontFamily={fontFamily}
                faceBoxes={faceBoxes}
                hasTopChapterPill={overlappingChapterPills.length > 0}
                activeSubtitles={overlappingSubs}
              />
            )}
            {item.kind === "countdown" && (
              <CountdownOverlay
                item={item}
                durationInFrames={durFrames}
                accentColor={accent}
                fontFamily={fontFamily}
                faceBoxes={faceBoxes}
              />
            )}
            {item.kind === "callout-sticker" && (
              <CalloutStickerOverlay
                item={item}
                durationInFrames={durFrames}
                accentColor={accent}
                fontFamily={fontFamily}
                faceBoxes={faceBoxes}
                seedIndex={idx}
                avoidBands={stickerAvoidBands}
              />
            )}
            {item.kind === "blooper-end" && (
              <BlooperEndOverlay
                item={item}
                durationInFrames={durFrames}
                accentColor={accent}
                fontFamily={fontFamily}
              />
            )}
          </Sequence>
        );
      })}
    </>
  );
}
