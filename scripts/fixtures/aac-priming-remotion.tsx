import React from "react";
import { AbsoluteFill, Audio, Composition, OffthreadVideo, registerRoot } from "remotion";

// Two compositions shaped like the real render chain, used by verify-export-audio-sync.ts:
// - Preview mirrors ShortVideoComposition: muted b-roll <OffthreadVideo> + voice <Audio>.
// - Burn mirrors SubtitleOverlayComposition: the preview MP4 as <OffthreadVideo> WITH its audio.

type Props = { videoSrc: string; audioSrc?: string };

function AacPrimingPreview({ videoSrc, audioSrc }: Props) {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <OffthreadVideo src={videoSrc} muted style={{ width: "100%", height: "100%" }} />
      {audioSrc && <Audio src={audioSrc} />}
    </AbsoluteFill>
  );
}

function AacPrimingBurn({ videoSrc }: Props) {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <OffthreadVideo src={videoSrc} style={{ width: "100%", height: "100%" }} />
    </AbsoluteFill>
  );
}

const shared = { durationInFrames: 60, fps: 30, width: 180, height: 320 } as const;

function Root() {
  return (
    <>
      <Composition
        id="AacPrimingPreview"
        component={AacPrimingPreview}
        {...shared}
        defaultProps={{ videoSrc: "", audioSrc: "" }}
      />
      <Composition id="AacPrimingBurn" component={AacPrimingBurn} {...shared} defaultProps={{ videoSrc: "" }} />
    </>
  );
}

registerRoot(Root);
