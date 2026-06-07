import React from "react";
import { AbsoluteFill, Audio, OffthreadVideo, Sequence, useVideoConfig } from "remotion";
import type { SubtitleOverlayConfig, SubtitleStylePreset, SubtitleTextEffect } from "./types";
import { AnimatedSubtitle } from "./ShortVideoComposition";

// Keep in sync with src/app/layout.tsx GOOGLE_FONTS_URL — burn output must use
// the same font files (and weights) as the editor preview.
const FONTS_CSS =
  "https://fonts.googleapis.com/css2?family=Mitr:wght@400;500;600;700&family=Kanit:wght@400;500;600;700;800;900&family=Sarabun:wght@400;500;600;700;800&family=Prompt:wght@400;500;600;700;800;900&family=Noto+Sans+Thai:wght@400;500;600;700;800;900&family=IBM+Plex+Sans+Thai:wght@400;500;600;700&family=Chakra+Petch:wght@400;500;600;700&family=Chonburi&family=Fahkwang:wght@400;500;600;700&family=K2D:wght@400;500;600;700;800&family=Charm:wght@400;700&family=Bai+Jamjuree:wght@400;600;700&family=Krub:wght@400;600;700&family=Pridi:wght@400;600;700&family=Itim&family=Sriracha&family=Oswald:wght@400;500;600;700&family=Anton&family=Bebas+Neue&display=swap";

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
  bgmFile,
  bgmVolume = 0.12,
}: SubtitleOverlayConfig) {
  const { width, height } = useVideoConfig();
  const resolvedFont = fontFamily || "'Kanit', 'Noto Sans Thai', sans-serif";
  const preset: SubtitleStylePreset = subtitleStylePreset ?? "stroke";
  const textEffect: SubtitleTextEffect = subtitleTextEffect ?? "pop";
  const accentColor = subtitleAccentColor ?? "#FFE500";

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", fontFamily: resolvedFont, overflow: "hidden" }}>
      <link rel="stylesheet" href={FONTS_CSS} />

      {/* Background video — plays WITH its original audio (TTS / voice). */}
      <OffthreadVideo
        src={videoUrl}
        style={{ position: "absolute", top: 0, left: 0, width, height, objectFit: "cover" }}
      />

      {/* Background music — mixed in here so the avatar path (whose composite has
          voice only) still gets BGM in the final burned video. Looped to cover
          the whole duration. */}
      {bgmFile && <Audio src={bgmFile} volume={bgmVolume ?? 0.12} loop />}

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
