"use client";

import { Player } from "@remotion/player";
import { AvatarComposition } from "@/remotion/AvatarComposition";
import type { Caption } from "@remotion/captions";
import { DEFAULT_CAPTION_STYLE, type CaptionStyleId, type CaptionStyleDef } from "@/remotion/captionStyles";

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

interface AvatarPlayerProps {
  avatarVideoUrl: string;
  videoDuration: number;
  captions: Caption[];
  captionStyleId?: CaptionStyleId;
  customCaptionStyle?: CaptionStyleDef | null;
  /** Vertical position 0 (top) – 100 (bottom). Default 85. */
  positionY?: number;
  fontSizeOverride?: number;
  fontWeightOverride?: number;
  bgVideoUrl?: string | null;
}

export function AvatarPlayer({
  avatarVideoUrl,
  videoDuration,
  captions,
  captionStyleId = DEFAULT_CAPTION_STYLE,
  customCaptionStyle,
  positionY = 85,
  fontSizeOverride,
  fontWeightOverride,
  bgVideoUrl,
}: AvatarPlayerProps) {
  const safeDuration = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : 60;
  const durationInFrames = Math.max(Math.round(safeDuration * FPS), FPS);

  return (
    <Player
      key={durationInFrames}
      component={AvatarComposition}
      inputProps={{ avatarVideoUrl, bgVideoUrl: bgVideoUrl ?? null, captions, captionStyleId, customCaptionStyle, positionY, fontSizeOverride, fontWeightOverride }}
      durationInFrames={durationInFrames}
      fps={FPS}
      compositionWidth={WIDTH}
      compositionHeight={HEIGHT}
      style={{
        width: "100%",
        borderRadius: 12,
        overflow: "hidden",
      }}
      controls
      loop
    />
  );
}
