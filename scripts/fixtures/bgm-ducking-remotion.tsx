import React from "react";
import { Composition, registerRoot } from "remotion";
import { SubtitleOverlayComposition } from "../../src/remotion/SubtitleOverlayComposition";
import type { SubtitleOverlayConfig } from "../../src/remotion/types";

// The REAL burn composition at a tiny size, used by verify-bgm-ducking-render.ts to prove the
// changed-music audio path (EP5 U7) on synthetic media.

const BurnFixture = (props: SubtitleOverlayConfig) => <SubtitleOverlayComposition {...props} />;

function Root() {
  return (
    <Composition
      id="BgmDuckingBurn"
      component={BurnFixture}
      durationInFrames={90}
      fps={30}
      width={180}
      height={320}
      defaultProps={{ videoUrl: "", durationInFrames: 90, keywordPopups: [] } satisfies SubtitleOverlayConfig}
    />
  );
}

registerRoot(Root);
