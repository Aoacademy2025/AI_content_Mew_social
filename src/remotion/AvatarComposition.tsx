import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption } from "@remotion/captions";
import { CaptionOverlay } from "./CaptionOverlay";
import { FONTS_IMPORT_URL, DEFAULT_CAPTION_STYLE, type CaptionStyleId, type CaptionStyleDef } from "./captionStyles";
import {
  isPunchZoomActiveAtTime,
  planPunchZoomIntervals,
  PUNCH_ZOOM_ORIGIN,
  PUNCH_ZOOM_SCALE,
  type PunchZoomInterval,
} from "../lib/presenter-punch-zoom";

const FONT_STYLE = `
  @import url('${FONTS_IMPORT_URL}');
  * { box-sizing: border-box; }
`;

export interface AvatarCompositionProps {
  avatarVideoUrl: string;
  captions: Caption[];
  captionStyleId?: CaptionStyleId;
  /** AI-generated or custom style — overrides captionStyleId */
  customCaptionStyle?: CaptionStyleDef | null;
  /** Vertical position 0 (top) – 100 (bottom). Default 85. */
  positionY?: number;
  fontSizeOverride?: number;
  fontWeightOverride?: number;
  /** EP5 #4: Auto punch-in zoom on the presenter video layer only (subtitles stay stationary). */
  punchZoom?: boolean;
  punchZoomIntervals?: PunchZoomInterval[];
}

export function AvatarComposition({
  avatarVideoUrl,
  captions,
  captionStyleId = DEFAULT_CAPTION_STYLE,
  customCaptionStyle,
  positionY = 85,
  fontSizeOverride,
  fontWeightOverride,
  punchZoom = false,
  punchZoomIntervals,
}: AvatarCompositionProps) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const currentTimeSec = frame / Math.max(1, fps);
  const totalDurationSec = durationInFrames / Math.max(1, fps);
  const resolvedIntervals = punchZoom
    ? (punchZoomIntervals ?? planPunchZoomIntervals(
        [{ start: 0, end: Math.max(1, totalDurationSec) }],
        captions.map((c) => c.startMs / 1000),
      ))
    : [];
  const zoomed = punchZoom && isPunchZoomActiveAtTime(resolvedIntervals, currentTimeSec);

  return (
    <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
      <style>{FONT_STYLE}</style>

      {/* avatarVideoUrl is already composited (avatar + BG) via ffmpeg colorkey */}
      <OffthreadVideo
        src={avatarVideoUrl}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          ...(zoomed
            ? {
                transform: `scale(${PUNCH_ZOOM_SCALE})`,
                transformOrigin: PUNCH_ZOOM_ORIGIN,
              }
            : {}),
        }}
      />

      {captions.length > 0 && (
        <CaptionOverlay
          captions={captions}
          captionStyleId={captionStyleId}
          customCaptionStyle={customCaptionStyle}
          positionY={positionY}
          fontSizeOverride={fontSizeOverride}
          fontWeightOverride={fontWeightOverride}
        />
      )}
    </AbsoluteFill>
  );
}
