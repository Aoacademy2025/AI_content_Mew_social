import React from "react";
import { AbsoluteFill, Composition, registerRoot } from "remotion";
import { renderSubtitle } from "../../src/remotion/renderSubtitle";

function SubtitleFitFixture({ text }: { text: string }) {
  return (
    <AbsoluteFill style={{ background: "#000", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: "92%", textAlign: "center" }}>
        {renderSubtitle(
          text,
          "#FFFFFF",
          80,
          false,
          "plain",
          "Arial, sans-serif",
          400,
          -1,
          1,
          "fade",
        )}
      </div>
    </AbsoluteFill>
  );
}

function Root() {
  return (
    <Composition
      id="SubtitleFitV2Fixture"
      component={SubtitleFitFixture}
      durationInFrames={1}
      fps={30}
      width={1080}
      height={480}
      defaultProps={{ text: "abcdefghij" }}
    />
  );
}

registerRoot(Root);
