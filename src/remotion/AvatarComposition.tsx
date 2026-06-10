import { AbsoluteFill, OffthreadVideo } from "remotion";
import type { Caption } from "@remotion/captions";
import { CaptionOverlay } from "./CaptionOverlay";
import { FONTS_IMPORT_URL, DEFAULT_CAPTION_STYLE, type CaptionStyleId, type CaptionStyleDef } from "./captionStyles";

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
}

export function AvatarComposition({
  avatarVideoUrl,
  captions,
  captionStyleId = DEFAULT_CAPTION_STYLE,
  customCaptionStyle,
  positionY = 85,
  fontSizeOverride,
  fontWeightOverride,
}: AvatarCompositionProps) {
  return (
    <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
      <style>{FONT_STYLE}</style>

      {/* avatarVideoUrl is already composited (avatar + BG) via ffmpeg colorkey */}
      <OffthreadVideo
        src={avatarVideoUrl}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
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
