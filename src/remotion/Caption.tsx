import { useCurrentFrame, interpolate, AbsoluteFill } from "remotion";

interface CaptionProps {
  text: string;
  totalFrames: number;
}

export function Caption({ text, totalFrames }: CaptionProps) {
  const frame = useCurrentFrame();

  const opacity = interpolate(
    frame,
    [0, 8, totalFrames - 8, totalFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const translateY = interpolate(frame, [0, 8], [12, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: "10%",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          opacity,
          transform: `translateY(${translateY}px)`,
          maxWidth: "85%",
          textAlign: "center",
        }}
      >
        <span
          style={{
            display: "inline-block",
            background: "rgba(0,0,0,0.72)",
            color: "#ffffff",
            fontSize: 38,
            fontFamily: "'Sarabun', 'Noto Sans Thai', sans-serif",
            fontWeight: 600,
            lineHeight: 1.5,
            padding: "10px 22px",
            borderRadius: 10,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            textShadow: "0 2px 8px rgba(0,0,0,0.8)",
          }}
        >
          {text}
        </span>
      </div>
    </AbsoluteFill>
  );
}
