import { AbsoluteFill, Sequence, Img, useVideoConfig, useCurrentFrame, interpolate } from "remotion";
import { Caption } from "./Caption";
import { parseTime } from "./types";
import type { VideoCompositionProps, SceneEffect } from "./types";

const FONT_STYLE = `
  @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap');
  * { box-sizing: border-box; }
`;

function AnimatedImage({ src, effect, durationFrames }: { src: string; effect?: SceneEffect; durationFrames: number }) {
  const frame = useCurrentFrame();
  const d = Math.max(durationFrames, 1);

  let transform: string;
  let opacity = 1;
  switch (effect) {
    case "zoom-in": {
      const s = interpolate(frame, [0, d], [1.0, 1.25], { extrapolateRight: "clamp" });
      transform = `scale(${s})`;
      break;
    }
    case "zoom-out": {
      const s = interpolate(frame, [0, d], [1.25, 1.0], { extrapolateRight: "clamp" });
      transform = `scale(${s})`;
      break;
    }
    case "pan-left": {
      const tx = interpolate(frame, [0, d], [4, -4], { extrapolateRight: "clamp" });
      transform = `scale(1.12) translateX(${tx}%)`;
      break;
    }
    case "pan-right": {
      const tx = interpolate(frame, [0, d], [-4, 4], { extrapolateRight: "clamp" });
      transform = `scale(1.12) translateX(${tx}%)`;
      break;
    }
    case "ken-burns": {
      const s = interpolate(frame, [0, d], [1.0, 1.3], { extrapolateRight: "clamp" });
      const tx = interpolate(frame, [0, d], [2, -3], { extrapolateRight: "clamp" });
      const ty = interpolate(frame, [0, d], [1, -2], { extrapolateRight: "clamp" });
      transform = `scale(${s}) translate(${tx}%, ${ty}%)`;
      break;
    }
    case "ken-burns-2": {
      const s = interpolate(frame, [0, d], [1.2, 1.0], { extrapolateRight: "clamp" });
      const tx = interpolate(frame, [0, d], [-3, 2], { extrapolateRight: "clamp" });
      const ty = interpolate(frame, [0, d], [-2, 1], { extrapolateRight: "clamp" });
      transform = `scale(${s}) translate(${tx}%, ${ty}%)`;
      break;
    }
    case "ken-burns-3": {
      const s = interpolate(frame, [0, d], [1.1, 1.35], { extrapolateRight: "clamp" });
      const tx = interpolate(frame, [0, d], [-4, 4], { extrapolateRight: "clamp" });
      const ty = interpolate(frame, [0, d], [3, -3], { extrapolateRight: "clamp" });
      transform = `scale(${s}) translate(${tx}%, ${ty}%)`;
      break;
    }
    case "pan-up": {
      const ty = interpolate(frame, [0, d], [4, -4], { extrapolateRight: "clamp" });
      transform = `scale(1.12) translateY(${ty}%)`;
      break;
    }
    case "pan-down": {
      const ty = interpolate(frame, [0, d], [-4, 4], { extrapolateRight: "clamp" });
      transform = `scale(1.12) translateY(${ty}%)`;
      break;
    }
    case "diagonal-tl": {
      const s = interpolate(frame, [0, d], [1.0, 1.2], { extrapolateRight: "clamp" });
      const tx = interpolate(frame, [0, d], [3, -3], { extrapolateRight: "clamp" });
      const ty = interpolate(frame, [0, d], [3, -3], { extrapolateRight: "clamp" });
      transform = `scale(${s}) translate(${tx}%, ${ty}%)`;
      break;
    }
    case "diagonal-br": {
      const s = interpolate(frame, [0, d], [1.2, 1.0], { extrapolateRight: "clamp" });
      const tx = interpolate(frame, [0, d], [-3, 3], { extrapolateRight: "clamp" });
      const ty = interpolate(frame, [0, d], [-3, 3], { extrapolateRight: "clamp" });
      transform = `scale(${s}) translate(${tx}%, ${ty}%)`;
      break;
    }
    case "fade-in": {
      transform = `scale(1.05)`;
      opacity = interpolate(frame, [0, Math.round(d * 0.4)], [0, 1], { extrapolateRight: "clamp" });
      break;
    }
    case "pulse": {
      const s = interpolate(frame, [0, d * 0.5, d], [1.0, 1.08, 1.0], { extrapolateRight: "clamp" });
      transform = `scale(${s})`;
      break;
    }
    default: {
      // Gentle default zoom-in so it never looks static
      const s = interpolate(frame, [0, d], [1.0, 1.1], { extrapolateRight: "clamp" });
      transform = `scale(${s})`;
    }
  }

  return (
    <div style={{ width: "100%", height: "100%", overflow: "hidden", background: "#000" }}>
      <Img
        src={src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform,
          opacity,
          transformOrigin: "center center",
          willChange: "transform",
          display: "block",
        }}
      />
    </div>
  );
}

export function VideoComposition({ scenes, captionSegments }: VideoCompositionProps) {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <style>{FONT_STYLE}</style>

      {scenes.map((scene, i) => {
        const { startSec, durationSec } = parseTime(scene.time);
        const fromFrame = Math.max(0, Math.round(startSec * fps));
        const toFrame = Math.max(fromFrame + 1, Math.round((startSec + durationSec) * fps));
        const durationFrames = Math.max(1, toFrame - fromFrame);

        return (
          <Sequence key={i} from={fromFrame} durationInFrames={durationFrames}>
            <AbsoluteFill style={{ background: "#000" }}>
              {scene.imageUrl ? (
                <AnimatedImage src={scene.imageUrl} effect={scene.effect} durationFrames={durationFrames} />
              ) : (
                <AbsoluteFill
                  style={{
                    background: `hsl(${(i * 60) % 360}, 40%, 15%)`,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 48, fontFamily: "sans-serif" }}>
                    Scene {i + 1}
                  </span>
                </AbsoluteFill>
              )}

              {!captionSegments && scene.caption && (
                <Caption text={scene.caption} totalFrames={durationFrames} />
              )}
            </AbsoluteFill>
          </Sequence>
        );
      })}

      {captionSegments && captionSegments.map((seg, i) => {
        const fromFrame = Math.max(0, Math.round(seg.start * fps));
        const toFrame = Math.max(fromFrame + 1, Math.round(seg.end * fps));
        const durationFrames = Math.max(1, toFrame - fromFrame);
        return (
          <Sequence key={`cap-${i}`} from={fromFrame} durationInFrames={durationFrames}>
            <Caption text={seg.text} totalFrames={durationFrames} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
