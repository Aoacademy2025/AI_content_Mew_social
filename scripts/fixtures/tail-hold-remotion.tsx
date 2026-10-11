import React from "react";
import { Composition, registerRoot } from "remotion";
import { SubtitleOverlayComposition } from "../../src/remotion/SubtitleOverlayComposition";
import type { SubtitleOverlayConfig } from "../../src/remotion/types";

// EP5 backlog #14: renders the REAL SubtitleOverlayComposition (not a stand-in) at two
// registered durations — "TailHoldOff" ends where the source video's content does, "TailHoldOn"
// is 30 frames (1s @30fps) longer with tailHoldFrames=30 — so verify-tail-hold.ts can prove the
// Freeze wrap actually holds the last base frame instead of letting the source play through.
const shared = { width: 180, height: 320, fps: 30 } as const;
const defaultProps: SubtitleOverlayConfig = { videoUrl: "", keywordPopups: [], durationInFrames: 60 };

function Root() {
  return (
    <>
      <Composition
        id="TailHoldOff"
        component={SubtitleOverlayComposition}
        {...shared}
        durationInFrames={60}
        defaultProps={defaultProps}
      />
      <Composition
        id="TailHoldOn"
        component={SubtitleOverlayComposition}
        {...shared}
        durationInFrames={90}
        defaultProps={{ ...defaultProps, durationInFrames: 90, tailHoldFrames: 30 }}
      />
    </>
  );
}

registerRoot(Root);
