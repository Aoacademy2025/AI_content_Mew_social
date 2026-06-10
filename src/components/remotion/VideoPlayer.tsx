"use client";

import { Player } from "@remotion/player";
import { VideoComposition } from "@/remotion/VideoComposition";
import type { SceneData, CaptionSegment } from "@/remotion/types";

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

interface VideoPlayerProps {
  scenes: SceneData[];
  audioUrl?: string | null;
  videoDuration: number; // seconds
  captionSegments?: CaptionSegment[] | null;
}

export function VideoPlayer({ scenes, audioUrl, videoDuration, captionSegments }: VideoPlayerProps) {
  const safeDuration = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : 60;
  const durationInFrames = Math.max(Math.round(safeDuration * FPS), FPS);

  return (
    <Player
      component={VideoComposition}
      inputProps={{ scenes, audioUrl, captionSegments }}
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
