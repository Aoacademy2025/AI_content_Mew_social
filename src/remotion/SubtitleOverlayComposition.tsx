import React from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, useVideoConfig } from "remotion";
import type { SubtitleOverlayConfig, SubtitleStylePreset, SubtitleTextEffect } from "./types";
import { AnimatedSubtitle } from "./ShortVideoComposition";

const FONTS_CSS =
  "https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;700;800&family=Kanit:wght@700;900&family=Prompt:wght@600;700&family=Mitr:wght@400;500;600&family=Noto+Sans+Thai:wght@400;700;900&family=K2D:wght@400;700;800&family=Charm:wght@400;700&family=IBM+Plex+Sans+Thai:wght@400;600;700&family=Itim&family=Bai+Jamjuree:wght@600;700&family=Chonburi&family=Pridi:wght@600;700&family=Krub:wght@600;700&display=swap";

/**
 * Burns subtitles onto a pre-rendered video using the EXACT same subtitle
 * renderer (renderSubtitle + AnimatedSubtitle) as ShortVideoComposition,
 * so what users see in Render preview matches what gets burned in.
 */
export function SubtitleOverlayComposition({
  videoUrl,
  keywordPopups,
  fontFamily,
  subtitleStylePreset = "stroke",
  subtitleTextEffect = "pop",
  subtitleAccentColor = "#FFE500",
}: SubtitleOverlayConfig) {
  const { width, height } = useVideoConfig();
  const resolvedFont = fontFamily || "'Kanit', 'Noto Sans Thai', sans-serif";
  const preset: SubtitleStylePreset = subtitleStylePreset ?? "stroke";
  const textEffect: SubtitleTextEffect = subtitleTextEffect ?? "pop";
  const accentColor = subtitleAccentColor ?? "#FFE500";

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", fontFamily: resolvedFont, overflow: "hidden" }}>
      <link rel="stylesheet" href={FONTS_CSS} />

      {/* Background video — plays WITH original audio (TTS + BGM already mixed in) */}
      <OffthreadVideo
        src={videoUrl}
        style={{ position: "absolute", top: 0, left: 0, width, height, objectFit: "cover" }}
      />

      {/* Subtitles — use the same Sequence + AnimatedSubtitle as ShortVideoComposition */}
      {keywordPopups.map((p) => {
        const dur = p.end - p.start;
        if (dur <= 0) return null;
        const capPreset = p.stylePreset ?? preset;
        return (
          <Sequence key={`sub-${p.start}-${p.end}`} from={p.start} durationInFrames={dur} layout="none">
            <AnimatedSubtitle
              popup={p}
              preset={capPreset}
              resolvedFont={resolvedFont}
              captionDurFrames={dur}
              textEffect={textEffect}
              accentColor={accentColor}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
