import React from "react";
import { Composition, registerRoot } from "remotion";
import { getVideoMetadata } from "@remotion/media-utils";
import { VideoComposition } from "./VideoComposition";
import { AvatarComposition } from "./AvatarComposition";
import { ShortVideoComposition } from "./ShortVideoComposition";
import { SubtitleOverlayComposition } from "./SubtitleOverlayComposition";
import type { VideoCompositionProps, ShortVideoConfig, SubtitleOverlayConfig } from "./types";
import type { AvatarCompositionProps } from "./AvatarComposition";

const DEFAULT_FPS = 30;
const DEFAULT_DURATION_FRAMES = 1800; // 60s
const TAIL_BUFFER_S = 1; // extra 1s so avatar finishes lip-sync

// Remotion 4.x Composition requires <Schema, Props> — cast to bypass Zod schema requirement
type AnyFC = React.ComponentType<Record<string, unknown>>;

const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="VideoComposition"
        component={VideoComposition as unknown as AnyFC}
        durationInFrames={DEFAULT_DURATION_FRAMES}
        fps={DEFAULT_FPS}
        width={1080}
        height={1920}
        defaultProps={
          {
            scenes: [],
            audioUrl: null,
          } as VideoCompositionProps as unknown as Record<string, unknown>
        }
      />
      <Composition
        id="AvatarComposition"
        component={AvatarComposition as unknown as AnyFC}
        durationInFrames={DEFAULT_DURATION_FRAMES}
        fps={DEFAULT_FPS}
        width={1080}
        height={1920}
        calculateMetadata={async ({ props }) => {
          const url = (props as unknown as AvatarCompositionProps).avatarVideoUrl;
          if (!url) return {};
          try {
            const meta = await getVideoMetadata(url);
            const frames = Math.ceil((meta.durationInSeconds + TAIL_BUFFER_S) * DEFAULT_FPS);
            return { durationInFrames: Math.max(frames, DEFAULT_FPS) };
          } catch {
            return {};
          }
        }}
        defaultProps={
          {
            avatarVideoUrl: "",
            captions: [],
            captionStyleId: "tiktok",
          } as AvatarCompositionProps as unknown as Record<string, unknown>
        }
      />
      <Composition
        id="ShortVideoComposition"
        component={ShortVideoComposition as unknown as AnyFC}
        durationInFrames={DEFAULT_DURATION_FRAMES}
        fps={DEFAULT_FPS}
        width={1080}
        height={1920}
        defaultProps={
          {
            bgVideos: [],
            keywordPopups: [],
            voiceFile: "",
            voiceVolume: 1,
            durationInFrames: DEFAULT_DURATION_FRAMES,
          } as ShortVideoConfig as unknown as Record<string, unknown>
        }
      />
      <Composition
        id="SubtitleOverlayComposition"
        component={SubtitleOverlayComposition as unknown as AnyFC}
        durationInFrames={DEFAULT_DURATION_FRAMES}
        fps={DEFAULT_FPS}
        width={1080}
        height={1920}
        calculateMetadata={async ({ props }) => {
          const url = (props as unknown as SubtitleOverlayConfig).videoUrl;
          if (!url) return {};
          try {
            const meta = await getVideoMetadata(url);
            const frames = Math.ceil(meta.durationInSeconds * DEFAULT_FPS);
            return { durationInFrames: Math.max(frames, DEFAULT_FPS) };
          } catch {
            return {};
          }
        }}
        defaultProps={
          {
            videoUrl: "",
            keywordPopups: [],
            durationInFrames: DEFAULT_DURATION_FRAMES,
          } as SubtitleOverlayConfig as unknown as Record<string, unknown>
        }
      />
    </>
  );
};

registerRoot(RemotionRoot);
