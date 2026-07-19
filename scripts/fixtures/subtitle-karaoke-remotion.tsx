import React from "react";
import { AbsoluteFill, Composition, registerRoot } from "remotion";
import { AnimatedSubtitle } from "../../src/remotion/ShortVideoComposition";

const CAPTION_DURATION_FRAMES = 45;

const KaraokeVisibilityFixture: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#5A3828" }}>
    <AnimatedSubtitle
      popup={{
        text: "ประมาณ 170 , 000 บาท",
        start: 0,
        end: CAPTION_DURATION_FRAMES,
        color: "#FFE500",
        accentColor: "#F87171",
        size: 107,
        isHighlight: false,
        topPercent: 20,
        stylePreset: "stroke",
        fontWeight: 900,
        tag: "body",
      }}
      preset="stroke"
      resolvedFont="Arial, sans-serif"
      captionDurFrames={CAPTION_DURATION_FRAMES}
      textEffect="karaoke"
      accentColor="#F87171"
    />
  </AbsoluteFill>
);

const RemotionFixtureRoot: React.FC = () => (
  <Composition
    id="SubtitleKaraokeVisibilityFixture"
    component={KaraokeVisibilityFixture}
    durationInFrames={CAPTION_DURATION_FRAMES}
    fps={30}
    width={540}
    height={960}
  />
);

registerRoot(RemotionFixtureRoot);
